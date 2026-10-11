package com.poc.buggy;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(BugController.class)
class BugControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void testCalculate_withZero_shouldReturnError() throws Exception {
        mockMvc.perform(get("/api/calculate").param("divisor", "0"))
               .andExpect(status().isOk())
               .andExpect(content().string("Cannot divide by zero"));
    }

    @Test
    void testCalculate_withNonZero_shouldReturnResult() throws Exception {
        mockMvc.perform(get("/api/calculate").param("divisor", "5"))
               .andExpect(status().isOk())
               .andExpect(content().string("20"));
    }

    @Test
    void testCalculate_withoutParam_shouldReturnError() throws Exception {
        mockMvc.perform(get("/api/calculate"))
               .andExpect(status().isOk())
               .andExpect(content().string("Cannot divide by zero"));
    }
}
